# plug.dj reverse engineering for lazy fucks

A braindead script that spews as-sexy-as-computerly-possible versions of plug.dj modules into a directory.

Minimal customizability, not enough automation. Awesome. :shipit:

Slap ReAnna if it doesn't work. (Metaphorically.)

0. `npm install` in this repo

---

1. Log in to plug.dj (lol)
1. Run [this](https://raw.githubusercontent.com/PlugLynn/plug-modules/master/plug-modules.js) in your browser console
1. Run the `getMapping.js` file in your browser console
1. It should give you a long string now, if it doesn't, type `fullMappingString`
1. Copy that string into a file on your machine, naming suggestions: `mapping.txt`, `plugdjautoRE.txt`, `a.txt`
1. Hit "View Source" while logged in to plug.dj, and find the main app javascript url (something crazy like "https://cdn.plug.dj/_/static/js/app.2f30d0efb2f0e0f486c7097fc70675409e1d159f.js")
1. Run the index.js file in this repo: `node index.js <mapping file> <app url>`, eg. `node index.js mapping.txt https://cdn.plug.dj/...`
1. Wait
1. Check `out/app` which will now contain a ton of files. Actual files are in a directory with a semi-random name, which is the actual plug.dj module name. Another directory `out/app/plug/` contains symlinks with nicer names where possible.

Remember to delete the `out/app/plug` directory every time you rerun, that directory only contains symlinks anyway.