PORT=3000
# Freshon MIS credentials. Put these in Render environment variables, never in GitHub.
FRESHON_BASE_URL=https://mis.freshon.co.kr/bo/main
FRESHON_ID=
FRESHON_PASSWORD=
# Optional admin protection for refresh endpoints.
ADMIN_TOKEN=change-me
# When true, anyone with the deployed link can view cached data.
PUBLIC_VIEW=true
# Scraper tuning. Adjust after confirming Freshon page selectors.
FRESHON_HEADLESS=true
FRESHON_NAV_TIMEOUT_MS=60000
