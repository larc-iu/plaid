SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

server-jar-file := server.jar
fe-module := main

ifeq ($(origin .RECIPEPREFIX), undefined)
  $(error This Make does not support .RECIPEPREFIX. Please use GNU Make 4.0 or later)
endif
.RECIPEPREFIX = >

shadow-server:
> yarn
> yarn shadow-cljs server

fe:
> bash ./scripts/start_dev.sh

prod-build: fe-release be-release

shadow-report:
> yarn shadow-cljs run shadow.cljs.build-report $(fe-module) fe-bundle-report.html

watch-$(fe-module):
> yarn shadow-cljs watch :$(fe-module)

watch: watch-$(fe-module)

watch-workspaces:
> yarn shadow-cljs watch :workspaces

watch-client-test:
> yarn shadow-cljs watch :test

fe-test:
> yarn shadow-cljs compile ci-tests
> yarn karma start --single-run
> clj -A:test -d src/test

watch-all: watch-$(fe-module)watch-workspaceswatch-client-test

fe-release:
> yarn shadow-cljs release $(fe-module)

deploy/$(server-jar-file):
> clojure -A:depstar -m hf.depstar.uberjar deploy/$(server-jar-file)

be-release: deploy/$(server-jar-file)

clean:
> rm -rf deploy/$(server-jar-file)

start-dev-server:
> clojure -A:dev

start-prod-server:
> pushd deploy
> java -cp app.jar clojure.main -m glam.server.server-entry

.PHONY: fe fe-release prod-build shadow-report watch-$(fe-module) watch shadow-server
.PHONY: watch-workspaces
.PHONY: fe-test watch-client-test
.PHONY: be-release clean start-dev-server start-prod-server
