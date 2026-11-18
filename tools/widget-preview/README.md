# Widget preview source

`widgets/<id>/preview-{light,dark}.png` are generated here (App Store guideline 1.10:
1024x1024, transparent, simple shapes, no text, no screenshot). `/tools/` is in `.homeyignore`.

    cd tools/widget-preview
    node gen.js
    for w in energy plan flows solar grid price battery ev; do
      for m in light dark; do
        google-chrome --headless --disable-gpu --hide-scrollbars \
          --default-background-color=00000000 --window-size=1024,1024 \
          --screenshot=$w-preview-$m.png $w-preview-$m.html
        cp $w-preview-$m.png ../../widgets/$w/preview-$m.png
      done
    done
