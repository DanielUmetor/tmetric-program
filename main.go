package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var keyRe = regexp.MustCompile(`^[A-Z][A-Z0-9]+-\d+`)

type Entry struct {
	ID      int64   `json:"id"`
	Key     string  `json:"key"`
	Note    string  `json:"note"`
	Start   string  `json:"start"`
	End     *string `json:"end"`
	Running bool    `json:"running"`
}

// spanReq is a finished time entry: a note plus date and From/To times.
type spanReq struct {
	Note  string `json:"note"`
	Date  string `json:"date"`  // 2026-11-10
	Start string `json:"start"` // 09:00
	End   string `json:"end"`   // 11:30
}

func (in spanReq) parse() (note string, s, e time.Time, err error) {
	note = strings.TrimSpace(in.Note)
	if note == "" {
		err = fmt.Errorf("description is required")
		return
	}
	if s, err = parseLocal(in.Date + " " + in.Start); err != nil {
		return
	}
	if e, err = parseLocal(in.Date + " " + in.End); err != nil {
		return
	}
	if !e.After(s) {
		err = fmt.Errorf("end must be after start")
		return
	}
	if e.After(time.Now()) {
		err = fmt.Errorf("end time is in the future")
		return
	}
	return
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		slog.Info("request", "method", r.Method, "path", r.URL.Path,
			"status", sw.status, "ms", time.Since(start).Milliseconds())
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, err error) {
	slog.Error("request failed", "err", err)
	http.Error(w, err.Error(), code)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// parseLocal parses "2006-01-02 15:04" or "2006-01-02T15:04" in local time.
func parseLocal(s string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02T15:04", "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid date/time %q", s)
}

func main() {
	jira := jiraClient{
		baseURL: os.Getenv("JIRA_URL"),
		email:   os.Getenv("JIRA_EMAIL"),
		token:   os.Getenv("JIRA_TOKEN"),
		project: envOr("JIRA_PROJECT", "CT"),
	}
	acc := os.Getenv("TMETRIC_ACCOUNT_ID")

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir("static")))

	mux.HandleFunc("GET /tickets", func(w http.ResponseWriter, r *http.Request) {
		tickets, err := jira.tickets(r.URL.Query().Get("scope"))
		if err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, tickets)
	})

	// Time entries between two dates (YYYY-MM-DD). Running ones have end == null.
	mux.HandleFunc("GET /entries", func(w http.ResponseWriter, r *http.Request) {
		from, err1 := time.ParseInLocation(dateLayout, r.URL.Query().Get("from"), time.Local)
		to, err2 := time.ParseInLocation(dateLayout, r.URL.Query().Get("to"), time.Local)
		if err1 != nil || err2 != nil {
			fail(w, http.StatusBadRequest, fmt.Errorf("from and to must be YYYY-MM-DD"))
			return
		}
		entries, err := listEntries(acc, from, to)
		if err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		out := make([]Entry, 0, len(entries))
		for _, e := range entries {
			out = append(out, Entry{
				ID: e.ID, Key: keyRe.FindString(e.Note), Note: e.Note,
				Start: e.StartTime, End: e.EndTime, Running: e.EndTime == nil,
			})
		}
		writeJSON(w, out)
	})

	// Start a timer from now. (Past time is logged as a From/To entry instead.)
	mux.HandleFunc("POST /start/{key}", func(w http.ResponseWriter, r *http.Request) {
		note := r.PathValue("key") + " " + r.URL.Query().Get("title")
		if _, err := stopAll(acc); err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		e, err := startTimer(acc, note, "")
		if err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		slog.Info("timer started", "note", note, "start", e.StartTime)
		writeJSON(w, e)
	})

	mux.HandleFunc("POST /stop", func(w http.ResponseWriter, r *http.Request) {
		n, err := stopAll(acc)
		if err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, map[string]int{"stopped": n})
	})

	// Add a finished entry (manual entry or past work).
	mux.HandleFunc("POST /log", func(w http.ResponseWriter, r *http.Request) {
		var in spanReq
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		note, s, e, err := in.parse()
		if err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		entry, err := logEntry(acc, note, s.Format(timeLayout), e.Format(timeLayout))
		if err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		slog.Info("time logged", "note", note, "start", s, "end", e, "dur", e.Sub(s))
		writeJSON(w, entry)
	})

	// Edit a finished entry (new note and/or From/To).
	mux.HandleFunc("PUT /entries/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			fail(w, http.StatusBadRequest, fmt.Errorf("bad entry id"))
			return
		}
		var in spanReq
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		note, s, e, err := in.parse()
		if err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		entry, err := updateEntry(acc, id, note, s.Format(timeLayout), e.Format(timeLayout))
		if err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		slog.Info("entry updated", "id", id, "note", note, "start", s, "end", e)
		writeJSON(w, entry)
	})

	mux.HandleFunc("DELETE /entries/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			fail(w, http.StatusBadRequest, fmt.Errorf("bad entry id"))
			return
		}
		if err := deleteEntry(acc, id); err != nil {
			fail(w, http.StatusBadGateway, err)
			return
		}
		slog.Info("entry deleted", "id", id)
		writeJSON(w, map[string]bool{"deleted": true})
	})

	slog.Info("listening", "url", "http://localhost:8080")
	if err := http.ListenAndServe("localhost:8080", logRequests(mux)); err != nil {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
