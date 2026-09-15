# Makefile for Search Does Search GNOME Shell Extension
# -------------------------------------------------------
# Targets:
#   make build        - Compile TypeScript and assemble dist/
#   make install      - Install extension to ~/.local/share/gnome-shell/extensions/
#   make enable       - Enable the extension via gnome-extensions CLI
#   make disable      - Disable the extension
#   make restart      - Restart GNOME Shell (X11 only)
#   make nested       - Build, install, and run it in a nested shell (windowed)
#   make nested-headless - Same, but with no window (virtual monitor)
#   make schemas      - Compile GSettings schemas
#   make check        - Run every test
#   make check-resources - Every resource:/// import resolves to a real file
#   make check-freeze - Regression test: cancel-per-keystroke must never block
#   make check-provider - Regression test: when a page load is (and is not) issued
#   make pack         - Package extension into .zip for extensions.gnome.org
#   make deb          - Build the .deb (system-scope install)
#   make rpm          - Build the .rpm (system-scope install)
#   make repos        - Build the signed APT + DNF site (needs SDS_KEY_ID)
#   make verify-repos - Check that site the way apt and dnf will
#   make clean        - Remove dist/ and compiled schemas
#   make logs         - Tail GNOME Shell logs (useful for debugging)

UUID       := search-does-search@searchdoessearch.github.io
DIST       := dist/$(UUID)
EXT_DIR    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR := $(DIST)/schemas

.PHONY: build install enable disable restart nested nested-headless schemas \
        check check-freeze check-provider check-resources pack deb rpm repos verify-repos clean logs

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

# Wayland has no equivalent of `make restart`: the Shell caches extension ES
# modules for the life of the session, so changed code needs a new session.
# scripts/nested-test.sh builds, installs, and starts one. Extra flags:
#   make nested NESTED_ARGS="--debug --verbose"
nested:
	./scripts/nested-test.sh $(NESTED_ARGS)

nested-headless:
	./scripts/nested-test.sh --headless $(NESTED_ARGS)

check: check-freeze check-provider check-resources

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

# A wrong resource:/// path is invisible to tsc and to `make pack`: it only
# surfaces in the process that imports it, which is how a broken prefs import
# shipped. The Shell-side paths are covered by nested-test.sh instead.
check-resources:
	@echo "→ Checking resource:/// imports..."
	@gjs -m scripts/check-resource-imports.js
	@echo "✓ Resource imports resolve"

# The provider decides when to load a page; getting it wrong either reloads on
# every keystroke or strands the user on a followed page.
check-provider: build
	@echo "→ Running provider load-decision test..."
	@GI_TYPELIB_PATH="$(SHELL_TYPELIBS):$$GI_TYPELIB_PATH" \
	 LD_LIBRARY_PATH="$(SHELL_TYPELIBS):$$LD_LIBRARY_PATH" \
	 timeout $(FREEZE_TIMEOUT) gjs -m scripts/provider-check.js || \
	 { echo "✗ Provider load decisions are wrong"; exit 1; }
	@echo "✓ Provider load decisions OK"

pack: build
	@echo "→ Packaging extension..."
	gnome-extensions pack $(DIST) \
		--schema=schemas/org.gnome.shell.extensions.search-does-search.gschema.xml \
		--extra-source=browserLauncher.js \
		--extra-source=pageView.js \
		--extra-source=rendererClient.js \
		--extra-source=searchProvider.js \
		--extra-source=section.js \
		--extra-source=stylesheet.css \
		--extra-source=panel \
		--force \
		--out-dir=.
	@echo "✓ Package created — ready to upload to extensions.gnome.org"

# ── Distribution packages ───────────────────────────────────────────────────
# Unlike the zip, these install into /usr/share and therefore ship no schemas/
# subfolder — see packaging/build-deb.sh for why that distinction matters.
deb: build
	./packaging/build-deb.sh

rpm: build
	./packaging/build-rpm.sh

# SDS_KEY_ID is the signing key id from scripts/bootstrap-signing-key.sh.
repos: deb rpm
	@test -n "$(SDS_KEY_ID)" || { echo "repos: set SDS_KEY_ID=<key id>"; exit 1; }
	./packaging/build-repos.sh --key "$(SDS_KEY_ID)" --out build/pages

verify-repos:
	./packaging/verify-repos.sh --site build/pages

clean:
	rm -rf dist/
	@echo "✓ Clean complete"

logs:
	journalctl --user -f -o cat | grep -iE 'searchdoessearch|SearchDoesSearch'
