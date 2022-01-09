# What's this?

An app for linguistic data annotation that's still under construction. It's built using [Clojure](https://clojure.org/)([Script](https://clojurescript.org/)), [Material-UI](https://material-ui.com/), [Fulcro](https://fulcro.fulcrologic.com/), and [XTDB](https://xtdb.com/main/index.html). 
For a short summary of this app's goals and vision, see [this post](https://forum.docling.net/t/glam-a-new-linguistic-annotation-app/606).
Check back soon 🚧

# Installation
*(These instructions are a sketch--more detailed instructions will be given later.)*

1. Secure a server that will run the app. We will assume you are using an Ubuntu machine.
2. Download [a JAR from the latest release](https://github.com/lgessler/glam/releases). 
3. [Configure the JAR as a service](https://dzone.com/articles/run-your-java-application-as-a-service-on-ubuntu).
4. Set up HTTPS. **If you do not set up HTTPS, your instance of Glam will be vulnerable to password-stealing attacks.** Fortunately, this is fairly easy--we recommend running Glam on the default port (8080) and using a reverse proxy like Nginx with [certbot](https://certbot.eff.org/) to provide HTTPS.

# Development

First, take care of dependencies. You will need to:

1. [Install Clojure CLI tools](https://clojure.org/guides/getting_started)
2. [Install NPM and Node](https://nodejs.org/en/download/)
3. [Install Yarn](https://yarnpkg.com/getting-started/install)

## Running: Command Line
```bash
# install dependencies
$ yarn
# start compiling CLJS--leave this running in a terminal session...
$ yarn client
# and in a separate session, start a server repl--note you'll have to type `(start)`
$ yarn server
clojure -A:dev
Clojure 1.10.1
user=> (start)
# navigate to localhost:8085, and see package.json for more
```

## Running: IntelliJ + Cursive
On the terminal:
```bash
yarn client
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

*Note*: all `docs` command will require additional dependencies for `asciidoctor`. Use `gem` to get them.

* **`client`**: Start the shadow-cljs ClojureScript compiler, which will compile code to JS and also hot reload any changes.
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
* `loc`: Count lines of code (requires `cloc`: `npm install -g cloc`).
* `docs/html`: Compile `docs/book.adoc` into HTML at `target/book.html`
* `docs/pdf`: Compile `docs/book.adoc` into a PDF at `target/book.pdf`
* `docs`: Perform `docs/html` and `docs/pdf`
