# Makefile for Search Does Search GNOME Shell Extension
# -------------------------------------------------------
# Targets:
#   make build        - Compile TypeScript and assemble dist/
#   make install      - Install extension to ~/.local/share/gnome-shell/extensions/
#   make enable       - Enable the extension via gnome-extensions CLI
#   make disable      - Disable the extension
#   make restart      - Restart GNOME Shell (X11 only)
#   make schemas      - Compile GSettings schemas
#   make searxng      - Start a local SearXNG instance with JSON output enabled
#   make searxng-stop - Remove that instance
#   make check        - Run every test
#   make check-freeze - Regression test: cancel-per-keystroke must never block
#   make check-fetch  - Smoke test: live query must yield results
#   make pack         - Package extension into .zip for extensions.gnome.org
#   make clean        - Remove dist/ and compiled schemas
#   make logs         - Tail GNOME Shell logs (useful for debugging)

UUID       := search-does-search@searchdoessearch.github.io
DIST       := dist/$(UUID)
EXT_DIR    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR := $(DIST)/schemas

# Must match the searxng-instance GSettings default so a fresh clone works untouched.
SEARXNG_PORT      := 8888
SEARXNG_INSTANCE  ?= http://localhost:$(SEARXNG_PORT)
SEARXNG_CONTAINER := sds-searxng

.PHONY: build install enable disable restart schemas searxng searxng-stop \
        check check-freeze check-fetch pack clean logs

# St and Meta ship outside the default typelib search path.
SHELL_TYPELIBS := /usr/lib/gnome-shell:$(firstword $(wildcard /usr/lib/*/mutter-*))
# A deadlock regression makes the harness hang rather than fail, so cap it.
FREEZE_TIMEOUT := 60

build:
	npm run build
	$(MAKE) schemas

schemas:
	@echo "→ Compiling GSettings schemas..."
	glib-compile-schemas $(SCHEMA_DIR)
	@echo "✓ Schemas compiled"

# Clears the target first: a plain copy leaves deleted modules behind, and a stale
# .js the Shell can still import is a debugging trap.
install: build
	@echo "→ Installing extension to $(EXT_DIR)..."
	rm -rf "$(EXT_DIR)"
	mkdir -p "$(EXT_DIR)"
	cp -r $(DIST)/. "$(EXT_DIR)/"
	@echo "✓ Extension installed"

enable:
	gnome-extensions enable $(UUID)
	@echo "✓ Extension enabled — open Activities and start typing"

disable:
	gnome-extensions disable $(UUID)
	@echo "✓ Extension disabled"

# X11 only: restart GNOME Shell without logging out
restart:
	@echo "→ Restarting GNOME Shell (X11 only)..."
	busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…", global.context)'

# SearXNG ships with JSON output disabled, so settings.yml is written before the
# first real start. The generated file is owned by the container's uid — write it
# through the container rather than from the host.
searxng:
	@command -v docker >/dev/null || { echo "docker is required"; exit 1; }
	@docker rm -f $(SEARXNG_CONTAINER) >/dev/null 2>&1 || true
	@echo "→ Starting SearXNG on port $(SEARXNG_PORT)..."
	@docker run -d --name $(SEARXNG_CONTAINER) --restart unless-stopped \
		-p $(SEARXNG_PORT):8080 \
		-e "SEARXNG_SECRET=$$(openssl rand -hex 32)" \
		-e "SEARXNG_BASE_URL=$(SEARXNG_INSTANCE)/" \
		searxng/searxng:latest >/dev/null
	@sleep 8
	@printf '%s\n' \
		'use_default_settings: true' \
		'' \
		'server:' \
		'  secret_key: "$(shell openssl rand -hex 32)"' \
		'  limiter: false' \
		'' \
		'search:' \
		'  formats:' \
		'    - html' \
		'    - json' \
		| docker exec -i -u root $(SEARXNG_CONTAINER) sh -c 'cat > /etc/searxng/settings.yml'
	@docker restart $(SEARXNG_CONTAINER) >/dev/null
	@sleep 12
	@echo "✓ SearXNG ready at $(SEARXNG_INSTANCE)"

searxng-stop:
	@docker rm -f $(SEARXNG_CONTAINER) >/dev/null 2>&1 && echo "✓ SearXNG removed" || echo "· no container to remove"

check: check-freeze check-fetch

# Replays the keystroke sequence that used to deadlock the compositor:
# every keystroke cancels the in-flight search while it is still awaiting.
check-freeze: build
	@echo "→ Running freeze regression test..."
	@GI_TYPELIB_PATH="$(SHELL_TYPELIBS):$$GI_TYPELIB_PATH" \
	 LD_LIBRARY_PATH="$(SHELL_TYPELIBS):$$LD_LIBRARY_PATH" \
	 timeout $(FREEZE_TIMEOUT) gjs -m scripts/keystroke-harness.js; \
	 status=$$?; \
	 if [ $$status -eq 124 ]; then \
	   echo "✗ DEADLOCK: cancel() never returned — this freezes GNOME Shell"; exit 1; \
	 elif [ $$status -ne 0 ]; then \
	   echo "✗ Freeze regression test failed"; exit 1; \
	 fi; \
	 echo "✓ No freeze regression"

check-fetch: build
	@echo "→ Running live fetch smoke test against $(SEARXNG_INSTANCE)..."
	@GI_TYPELIB_PATH="$(SHELL_TYPELIBS):$$GI_TYPELIB_PATH" \
	 LD_LIBRARY_PATH="$(SHELL_TYPELIBS):$$LD_LIBRARY_PATH" \
	 SEARXNG_INSTANCE="$(SEARXNG_INSTANCE)" \
	 timeout $(FREEZE_TIMEOUT) gjs -m scripts/fetch-check.js "gnome shell extension" "$(SEARXNG_INSTANCE)" || \
	 { echo "✗ No results — is the instance running? Try: make searxng"; exit 1; }
	@echo "✓ Fetch pipeline OK"

pack: build
	@echo "→ Packaging extension..."
	gnome-extensions pack $(DIST) \
		--schema=schemas/org.gnome.shell.extensions.search-does-search.gschema.xml \
		--extra-source=browserLauncher.js \
		--extra-source=pageView.js \
		--extra-source=rendererClient.js \
		--extra-source=searchProvider.js \
		--extra-source=webSearch.js \
		--extra-source=panel \
		--force \
		--out-dir=.
	@echo "✓ Package created — ready to upload to extensions.gnome.org"

clean:
	rm -rf dist/
	@echo "✓ Clean complete"

logs:
	journalctl --user -f -o cat | grep -iE 'searchdoessearch|SearchDoesSearch'
