# Purpose
Test fixture: media a hostile template author controls. `page.png` is HTML that
its template.json claims is `text/html`; `logo.svg` carries a script. Neither may
ever run as libi when its URL is opened. `real.png` and `clip.mp4` are ordinary
media that must keep rendering.
