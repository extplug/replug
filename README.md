# non-lethal plug.dj reverse engineering

A messy script that spews as-readable-as-computerly-possible versions of plug.dj
modules into a directory.

## usage

The easiest way to use replug is with [npx](https://npmjs.com/package/npx):

1. `npx replug`

Alternatively, install the CLI globally (you'll have to update manually from time to time):

1. `npm install -g replug`
1. `replug`

There are some command-line options:

    -h, --help            output usage information
    -V, --version         output the version number
    -m, --mapping [file]  File containing the mapping JSON (optional, it's auto-generated if no file is given)
    -o, --out [dir]       Output directory [out/]
    -v, --verbose         Use verbose output instead of bullet list

### examples

Dump output in `out/`:

```
npx replug
```

Output in `output-directory/`:

```
npx replug --out output-directory
```

## Licence

[MIT](./LICENSE)
