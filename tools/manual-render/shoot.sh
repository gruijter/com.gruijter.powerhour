#!/bin/bash
# usage: shoot.sh widget start
w=$1; st=$2
s=$(python3 -c "import json,urllib.parse;print(urllib.parse.quote(json.dumps({'start':'$st'})))")
google-chrome --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=400,700 \
  --virtual-time-budget=8000 --run-all-compositor-stages-before-draw \
  --screenshot=out/$w.png "http://localhost:8765/w/$w/index.html?s=$s" >/dev/null 2>&1
