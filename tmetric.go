package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"time"
)

const (
	tmetricBase = "https://app.tmetric.com/api/v3"
	timeLayout  = "2006-01-02T15:04:05"
	dateLayout  = "2006-01-02"
)

type TimeEntry struct {
	ID        int64   `json:"id"`
	Note      string  `json:"note"`
	StartTime string  `json:"startTime"`
	EndTime   *string `json:"endTime"`
}

func tmetricRequest(method, path string, body any) ([]TimeEntry, error) {
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, tmetricBase+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("TMETRIC_TOKEN"))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		slog.Error("tmetric error", "method", method, "path", path, "status", resp.Status, "body", string(raw))
		return nil, fmt.Errorf("tmetric %s returned %s", method, resp.Status)
	}
	var entries []TimeEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		slog.Error("tmetric unexpected response", "path", path, "body", string(raw))
		return nil, fmt.Errorf("unexpected tmetric response: %w", err)
	}
	return entries, nil
}

func one(entries []TimeEntry, err error) (TimeEntry, error) {
	if err != nil {
		return TimeEntry{}, err
	}
	if len(entries) == 0 {
		return TimeEntry{}, fmt.Errorf("tmetric returned no entries")
	}
	return entries[0], nil
}

// startTimer starts a running timer. Empty start means "now".
func startTimer(acc, note, start string) (TimeEntry, error) {
	if start == "" {
		start = time.Now().Format(timeLayout)
	}
	body := map[string]any{"startTime": start, "note": note}
	return one(tmetricRequest("POST", "/accounts/"+acc+"/timeentries", body))
}

// logEntry records finished time (past start and end).
func logEntry(acc, note, start, end string) (TimeEntry, error) {
	body := map[string]any{"startTime": start, "endTime": end, "note": note}
	return one(tmetricRequest("POST", "/accounts/"+acc+"/timeentries", body))
}

func listEntries(acc string, from, to time.Time) ([]TimeEntry, error) {
	q := url.Values{}
	q.Set("startDate", from.Format(dateLayout))
	q.Set("endDate", to.Format(dateLayout))
	return tmetricRequest("GET", "/accounts/"+acc+"/timeentries?"+q.Encode(), nil)
}

// runningEntries returns entries with no end time (yesterday and today).
func runningEntries(acc string) ([]TimeEntry, error) {
	now := time.Now()
	all, err := listEntries(acc, now.AddDate(0, 0, -1), now)
	if err != nil {
		return nil, err
	}
	var running []TimeEntry
	for _, e := range all {
		if e.EndTime == nil {
			running = append(running, e)
		}
	}
	return running, nil
}

func stopEntry(acc string, e TimeEntry) error {
	body := map[string]any{
		"startTime": e.StartTime,
		"endTime":   time.Now().Format(timeLayout),
		"note":      e.Note,
	}
	path := fmt.Sprintf("/accounts/%s/timeentries/%d", acc, e.ID)
	_, err := tmetricRequest("PUT", path, body)
	return err
}

// stopAll stops every running timer, then verifies none are left.
func stopAll(acc string) (int, error) {
	running, err := runningEntries(acc)
	if err != nil {
		return 0, err
	}
	for _, e := range running {
		if err := stopEntry(acc, e); err != nil {
			return 0, err
		}
		slog.Info("stopped entry", "id", e.ID, "note", e.Note)
	}
	if len(running) > 0 {
		left, err := runningEntries(acc)
		if err != nil {
			return len(running), err
		}
		if len(left) > 0 {
			slog.Error("timers still running after stop", "count", len(left), "first_id", left[0].ID)
			return len(running), fmt.Errorf("tmetric still shows %d running timer(s) after stop", len(left))
		}
	}
	return len(running), nil
}

// updateEntry rewrites a finished entry's note and From/To.
func updateEntry(acc string, id int64, note, start, end string) (TimeEntry, error) {
	body := map[string]any{"startTime": start, "endTime": end, "note": note}
	path := fmt.Sprintf("/accounts/%s/timeentries/%d", acc, id)
	return one(tmetricRequest("PUT", path, body))
}

// deleteEntry removes an entry. Accepts any 2xx and ignores the body.
func deleteEntry(acc string, id int64) error {
	url := fmt.Sprintf("%s/accounts/%s/timeentries/%d", tmetricBase, acc, id)
	req, err := http.NewRequest("DELETE", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("TMETRIC_TOKEN"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		raw, _ := io.ReadAll(resp.Body)
		slog.Error("tmetric delete failed", "id", id, "status", resp.Status, "body", string(raw))
		return fmt.Errorf("tmetric DELETE returned %s", resp.Status)
	}
	return nil
}
