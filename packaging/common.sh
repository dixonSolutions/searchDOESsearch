#!/usr/bin/env bash
# Shared identity for every package and repository this project publishes.
#
# One definition of the name, version and install layout: the .deb control file,
# the .spec, the repository metadata and the install docs all read it from here,
# so a version bump is one edit and the four cannot drift apart.

UUID="search-does-search@searchdoessearch.github.io"
PKG_NAME="gnome-shell-extension-search-does-search"
# The user-facing version. metadata.json's version-name must match; EGO assigns
# its own integer `version` on upload and ignores anything we put there.
VERSION="$(node -p "require('$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/package.json').version" 2>/dev/null || echo 0.0.0)"
RELEASE="1"

MAINTAINER="dixonSolutions <apt-signing@searchdoessearch.github.io>"
HOMEPAGE="https://github.com/dixonSolutions/searchDOESsearch"
PAGES_URL="https://dixonsolutions.github.io/searchDOESsearch"

SUMMARY="Web results directly in system search"
DESCRIPTION="Type in the GNOME overview and the engine's own results page renders
right there in the search list — scroll it, click it, follow links in place.
Nothing is handed to a browser until you ask for it, and which browser that is
stays your system default."

# Where a system-scope extension lives. Unlike a user install, it ships no
# schemas/ subfolder: gnome-shell reads the compiled schema from its own prefix
# when the extension directory has none (sharedInternals.js getSettings).
EXT_INSTALL_DIR="/usr/share/gnome-shell/extensions/${UUID}"
SCHEMA_INSTALL_DIR="/usr/share/glib-2.0/schemas"
SCHEMA_FILE="org.gnome.shell.extensions.search-does-search.gschema.xml"
