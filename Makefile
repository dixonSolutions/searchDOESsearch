# Makefile for Search Does Search GNOME Shell Extension
# -------------------------------------------------------
# Targets:
#   make build      - Compile TypeScript and assemble dist/
#   make install    - Install extension to ~/.local/share/gnome-shell/extensions/
#   make enable     - Enable the extension via gnome-extensions CLI
#   make disable    - Disable the extension
#   make restart    - Restart GNOME Shell (X11 only)
#   make schemas    - Compile GSettings schemas
#   make pack       - Package extension into .zip for extensions.gnome.org
#   make clean      - Remove dist/ and compiled schemas
#   make logs       - Tail GNOME Shell logs (useful for debugging)

UUID       := search-does-search@searchdoessearch.github.io
DIST       := dist/$(UUID)
EXT_DIR    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR := $(DIST)/schemas

.PHONY: build install enable disable restart schemas pack clean logs

build:
	npm run build
	$(MAKE) schemas

schemas:
	@echo "→ Compiling GSettings schemas..."
	glib-compile-schemas $(SCHEMA_DIR)
	@echo "✓ Schemas compiled"

install: build
	@echo "→ Installing extension to $(EXT_DIR)..."
	mkdir -p $(EXT_DIR)
	cp -r $(DIST)/. $(EXT_DIR)/
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

pack: build
	@echo "→ Packaging extension..."
	gnome-extensions pack $(DIST) \
		--schema=schemas/org.gnome.shell.extensions.search-does-search.gschema.xml \
		--extra-source=browserLauncher.js \
		--extra-source=searchProvider.js \
		--extra-source=webSearch.js \
		--force \
		--out-dir=.
	@echo "✓ Package created — ready to upload to extensions.gnome.org"

clean:
	rm -rf dist/
	@echo "✓ Clean complete"

logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i "searchdoessearch\|SearchDoesSearch"
