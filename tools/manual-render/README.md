# Manual widget renders

`manual/images/widget-<id>.png`: each widget page with real data, light, 800 px wide, English.

1. Record which API calls the widgets make (Dev, local token):
   `set -a; . ~/.config/homey-keys/dev.env; set +a; LIVE=1 node server.js` and in another shell
   `for x in energy:day flows:day plan:today price:today grid:today solar:today battery:today ev:today; do ./shoot.sh ${x%%:*} ${x##*:}; done`
   → `calls.log`.
2. Snapshot those calls from Prod (cloud, few calls): per line `<widget> <path>` of `sort -u calls.log`
   `homey api raw --homey-id <prod id> --path "/api/app/com.gruijter.powerhour/widget/<widget>/api<path>" --json > snap/<widget>_<base64url(path)>.json`
3. `node server.js` (snapshots only, names translated by `names.json`, not in git), run the shoot loop again,
   trim the white bottom, copy `out/<id>.png` to `manual/images/widget-<id>.png`.
