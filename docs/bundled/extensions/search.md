# Search

Devin Search adds two tools that share one Devin sign-in:

| Tool | What it does |
|---|---|
| `code_search` | Finds where behavior lives in the local repository from a plain-language description |
| `web_search` | Searches the live web and returns page excerpts |

In the transcript, each call is one line: the query, then live progress while it runs and the number of files or results once it finishes. Expand it (`Ctrl+O` or a click) to see the files with their line ranges, or the result titles with their sites; titles open the page. A failed call always shows its error.

## Signing in

Run `/search` to open the Devin Search panel. It shows whether you are signed in and offers:

- **Sign in with browser** opens `app.devin.ai` (the panel also shows the link, and the copy key copies it). Approve access, then paste the code Devin shows into the panel. Pasting a session token there works too.
- **Paste a token** saves an existing Devin session token.
- **Sign out** removes the saved token after a confirmation.

The panel checks every new token with Devin before saving it, so a rejected token never replaces a working one. The token is saved, exactly as Devin issued it, to `~/.pi/agent/search-auth.json`.

For headless and CI runs, set `SEARCH_KEY` to a Devin session token. A saved token takes precedence over it.

Without a credential, a session starts with both tools turned off. Signing in turns them on; turning one off with `/tools` is respected.

## code_search

`code_search` sends your query and a directory tree of the working directory (up to three levels, without dependency, build, and `.gitignore`d directories) to Devin's SWE-grep model. The model plans up to three rounds of up to eight read-only commands, `rg`, `readfile`, and `tree`, which run on your machine, and then answers with files and line ranges. The result is a reading list to verify, not evidence.

What leaves your machine: the query, the directory tree, and the output of the commands the model runs, including the file contents it reads.

Enforced locally, not by Devin:

- **Confinement.** Every path the model names must resolve inside the searched directory, both as written and after following symlinks.
- **Read-only.** The three commands are the only operations; there is no shell and no write.
- **Bounded output.** Each command result is capped at 40 lines of 200 characters, and each request times out after 30 seconds.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | The behavior, flow, error, or concept to locate, in concise English. Keep identifiers and error text verbatim |
| `path` | string | working directory | Subdirectory to search; must be inside the working directory |

## web_search

`web_search` returns up to 10 results, each with a title, URL, and the parts of the page that match the query (shortened to 1,500 characters).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Search query. Be specific: product names, versions, exact error text |
| `max_results` | int 1–10 | 5 | Results to return |
