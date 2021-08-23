# What's this?

An app for annotating linguistic data that's still under construction. It's built using [Clojure](https://clojure.org/)([Script](https://clojurescript.org/)), [Material-UI](https://material-ui.com/), [Fulcro](https://fulcro.fulcrologic.com/), and [Crux](https://opencrux.com/main/index.html). Check back soon 🚧

# Installation
*Coming soon*

# Development

First, take care of dependencies. You will need to:

1. [Install Clojure CLI tools](https://clojure.org/guides/getting_started)
2. [Install NPM and Node](https://nodejs.org/en/download/)
3. [Install Yarn](https://yarnpkg.com/getting-started/install)

## Running: Command Line
```bash
# install dependencies
$ yarn
# start compiling CLJS, and start a server repl--note you'll have to type `(start)`
$ yarn start
clojure -A:dev
Clojure 1.10.1
user=> (start)
# navigate to localhost:8085, and see package.json for more
```

## Running: IntelliJ + Cursive
On the terminal:
```bash
yarn client/main
```

Clojure Server Profile:

1. Make a new profile based on "Clojure REPL > Local"
2. Select "Run with Deps"
3. Put `dev` in Aliases
4. Run and write (start)
5. See `src/dev/user.clj` for development tools.

ClojureScript Client Profile:

1. Make a new profile based on "Clojure REPL > Remote"
2. Connection type: `nREPL` 
3. Connection details: "Use port from nREPL file" 
4. Project: `glam`
5. Make sure you're entered `(start)` in the server. 
6. Navigate to `localhost:8085`
7. Run your client profile and enter:
```clojure
(require '[shadow.cljs.devtools.api :as shadow])
(shadow/repl :main)
```
8. Write `(js/console.log "hi")` and ensure that it was printed out to the console in your browser session

## Yarn Commands

* **`client/main`**: Start the shadow-cljs ClojureScript compiler, which will compile code to JS and also hot reload any changes.
* `client/cljs-repl`: Get a client CLJS REPL (note: requires a running browser session).
* `client/clj-repl`: Get a client CLJ REPL (note: this is only useful if you want to fiddle with shadow-cljs, which is rare).
* **`server`**: Start a server REPL. (This will not start the server automatically--to do that, you need to type `(start)`.) 
* **`start`**: Convenience function for running `client/main` and `server`.
* `clean`: Remove all compilation artefacts. 
* `client/release`: Build the single `.js` bundle for a production release.
* `server/release`: Build the single `.jar` file for a production release.
* `release`: Convenience function for running `client/release` and `server/release`.
* `test`: Run all Clojure tests. (Currently, there are no CLJS tests.)
* `clojure-outdated`: Check Clojure dependencies for oudatedness.
* `npm-outdated`: Check NPM dependencies for outdatedness.
