# Link Layouts + MySQL
Your index.html needs `<div id="topbar"></div>`, `<div id="content"></div>`
and `<script src="app.js"></script>` (same as before).

Run:

    npm install
    # MySQL must be running. Set credentials if not root with no password:
    #   set DB_USER=root & set DB_PASSWORD=yourpass      (Windows cmd)
    #   DB_USER=root DB_PASSWORD=yourpass npm start      (macOS/Linux)
    npm start

Open http://localhost:3000. The database (`link_layouts`) and its tables
are created automatically on first start.

If the server is not running, the app still works using browser storage
and shows an "Offline" badge.
