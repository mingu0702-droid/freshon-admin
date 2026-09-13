# Stage dated assignments deployment

- Apps Script version 40; Stage-only new deployment:
  AKfycby2GWkBTo3v1u9YsDIpmwGUNIGP4UHuaAnP2HAujA4oKgsWV0sj68wjxP_H1iL5Opu2
- Existing Production v39 deployment is unchanged.
- Pulled source backup: sibling work/hub-dated-assignments-stage/reference-before-pagination-20260913.
- Added HubDatedAssignments.js. Only other Hub edit registers
  `datedAssignments: hubDatedAssignmentsPage_` in HubMapHttpApi.js handlers.
- Uses existing HubDataLayer.getDailyRoutes / CustomerDataApi v42 nextToken,
  date boundaries and bulk coordinate lookup. No data/trigger/index rebuild execution.
- Actual source is Customer daily_routes (current/archive selected by existing library),
  not materialized hub_daily_routes. Source meta.total is checked across pages.
- Render assembles sequential 1000-row pages and caches only the verified complete
  aggregate for ten minutes. No per-page Render cache, geographic tiling or vehicle fan-out.
- Roll back Stage by deploying a302f86 and removing its service-specific HUB_API_URL
  override. Do not modify the shared environment group or Production deployment.
