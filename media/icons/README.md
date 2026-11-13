# Ansible Flow Server — icon set
Sibling of the Ansible Flow Designer icon: same teal tile, plus an indigo server badge.

svg/afs-icon.svg         Master vector, full detail (48 px and up)
svg/afs-icon-small.svg   Simplified vector for 16–32 px (bigger badge, no checkmarks/text bars)
svg/afs-glyph.svg        Monochrome glyph (currentColor) for toolbars, menus, CLI docs
png/icon.png             256×256 general-purpose icon
png/afs-icon-<size>.png  16, 24, 32, 48, 64, 128, 256, 512, 1024 px
ico/afs-icon.ico         Windows, multi-size 16–256
ico/afs-icon.icns        macOS
pdf/afs-icon.pdf         Vector for print / docs
web/                     favicon.ico, favicon.svg, apple-touch-icon.png (180), icon-192.png, icon-512.png

Colors: tile #14B8A6, badge #6366F1, pills #0B1220, accent #0D9488, bars #475569, white #FFFFFF

Web UI <head>:
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">

site.webmanifest:
  { "name": "Ansible Flow Server", "short_name": "Flow Server",
    "icons": [ { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
               { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" } ],
    "theme_color": "#14B8A6", "background_color": "#0B1220", "display": "standalone" }
