package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

type Ticket struct {
	Key      string `json:"key"`
	Summary  string `json:"summary"`
	Status   string `json:"status"`
	Category string `json:"category"` // new | indeterminate | done
	Priority string `json:"priority"`
	DueDate  string `json:"dueDate"`
	Assignee string `json:"assignee"`
	URL      string `json:"url"`
}

type jiraIssue struct {
	Key    string `json:"key"`
	Fields struct {
		Summary string `json:"summary"`
		Status  struct {
			Name           string `json:"name"`
			StatusCategory struct {
				Key string `json:"key"`
			} `json:"statusCategory"`
		} `json:"status"`
		Priority *struct {
			Name string `json:"name"`
		} `json:"priority"`
		DueDate  *string `json:"duedate"`
		Assignee *struct {
			DisplayName string `json:"displayName"`
		} `json:"assignee"`
	} `json:"fields"`
}

type jiraClient struct {
	baseURL, email, token, project string
}

// tickets returns tickets in open sprints. scope: "mine" or "all".
func (j jiraClient) tickets(scope string) ([]Ticket, error) {
	jql := "assignee = currentUser() AND sprint in openSprints()"
	if scope == "all" {
		jql = fmt.Sprintf("project = %s AND sprint in openSprints()", j.project)
	}
	jql += " ORDER BY priority DESC, updated DESC"

	q := url.Values{}
	q.Set("jql", jql)
	q.Set("fields", "summary,status,priority,duedate,assignee")
	q.Set("maxResults", "100")

	req, err := http.NewRequest("GET", j.baseURL+"/rest/api/3/search/jql?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(j.email, j.token)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jira returned %s", resp.Status)
	}

	var sr struct {
		Issues []jiraIssue `json:"issues"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&sr); err != nil {
		return nil, err
	}

	out := make([]Ticket, 0, len(sr.Issues))
	for _, i := range sr.Issues {
		t := Ticket{
			Key:      i.Key,
			Summary:  i.Fields.Summary,
			Status:   i.Fields.Status.Name,
			Category: i.Fields.Status.StatusCategory.Key,
			URL:      j.baseURL + "/browse/" + i.Key,
		}
		if i.Fields.Priority != nil {
			t.Priority = i.Fields.Priority.Name
		}
		if i.Fields.DueDate != nil {
			t.DueDate = *i.Fields.DueDate
		}
		if i.Fields.Assignee != nil {
			t.Assignee = i.Fields.Assignee.DisplayName
		}
		out = append(out, t)
	}
	return out, nil
}
