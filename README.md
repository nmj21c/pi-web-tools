# pi-web-tools

Pi extension providing web search, page scraping, screenshot, and markdown extraction tools. Automatically manages SearXNG and Browserless Docker services on startup.

## Tools

| Tool | Description |
|------|-------------|
| `searxng_search` | Search the web via local SearXNG (port 17080) |
| `jina_reader` | Extract clean Markdown from any URL via Jina Reader API |
| `browserless_scrape` | Scrape web pages with CSS selectors via Browserless (port 17081) |
| `browserless_screenshot` | Take full-page screenshots via Browserless |

## Installation

```bash
# Via npm
pi install npm:pi-web-tools

# Via git
pi install git:github.com/your-username/pi-web-tools

# Local development
pi install ./path/to/pi-web-tools
```

## Usage

Once installed, the extension automatically starts required Docker services (SearXNG, Browserless) when pi launches. A status indicator `web-tools ready` appears in the footer bar.

### Manual Service Control

Use `/search-services` command to check status or manually restart services.

## Docker Services

The package includes `docker-compose.yml` with:

- **SearXNG** (`localhost:17080`) — Privacy-respecting metasearch engine
- **Browserless** (`localhost:17081`) — Headless Chrome for scraping and screenshots

If `docker-compose.yml` is not found in your workspace, the bundled version from the package is used automatically.

## Requirements

- Docker / Docker Desktop
- `docker compose` v2+

## License

MIT
