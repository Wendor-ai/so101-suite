# hello module

The smallest module there is. Copy this folder to `modules/<your_id>/`, change `module.json` (the `id` must match the folder name,
lowercase letters, digits and underscores), and restart the app: the Suite finds it by itself.

* `module.json` describes the module and its pages.
* `backend.py` answers `/api/m/hello/<path>` (see the docstring for the `handle` function).
* `ui.js` is the page. It is an ES module served at `/suite/modules/hello/ui.js`.

A module that breaks is listed with its error in the Modules page; it never stops the app.
