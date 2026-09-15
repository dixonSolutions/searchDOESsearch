# Version and release come from packaging/common.sh via --define, so this spec
# never has to be edited for a release.
%global uuid    search-does-search@searchdoessearch.github.io
%global extdir  %{_datadir}/gnome-shell/extensions/%{uuid}

Name:           gnome-shell-extension-search-does-search
Version:        %{sds_version}
Release:        %{sds_release}%{?dist}
Summary:        Web results directly in system search

License:        MIT
URL:            https://github.com/dixonSolutions/searchDOESsearch
Source0:        %{name}-%{version}.tar.gz
BuildArch:      noarch

# The results page is rendered by a separate GJS process running GTK 3 + WebKit2
# 4.1 — GNOME Shell is a Clutter compositor and cannot host a WebKit widget. The
# typelib requires are what actually matter; the extension is inert without them.
Requires:       gnome-shell >= 48
Requires:       gjs
Requires:       typelib(WebKit2) = 4.1
Requires:       typelib(Gtk) = 3.0
Recommends:     xdg-utils

%description
A glance at a results page, not a browser. Type in the GNOME overview and the
engine's own results page renders right there in the search list: read it, scroll
it, click into a result without ever leaving the overview. It is for the search
you would rather not open a browser for.

There is no address bar, no tabs, no forward button and no history. When you want
the actual web, press Enter and your default browser takes over.

The extension is installed system-wide but not enabled. Enable it with:
    gnome-extensions enable search-does-search@searchdoessearch.github.io

%prep
%setup -q -c

%install
install -d %{buildroot}%{extdir}
cp -r ./* %{buildroot}%{extdir}/
# The tarball carries LICENSE and README.md for %license/%doc; they are not part
# of the extension the Shell loads.
rm -f %{buildroot}%{extdir}/LICENSE %{buildroot}%{extdir}/README.md

# A system extension must ship no schemas/ subfolder: gnome-shell falls back to
# its own prefix only when the extension directory has none, and a stale local
# copy would shadow the packaged schema after an upgrade.
install -d %{buildroot}%{_datadir}/glib-2.0/schemas
mv %{buildroot}%{extdir}/schemas/org.gnome.shell.extensions.search-does-search.gschema.xml \
   %{buildroot}%{_datadir}/glib-2.0/schemas/
rm -rf %{buildroot}%{extdir}/schemas
find %{buildroot}%{extdir} -name '*.js.map' -delete

chmod 0755 %{buildroot}%{extdir}/panel/sds-renderer.js

%post
# Fedora's glib2 carries a file trigger for this; distributions without one would
# otherwise leave a schema gnome-shell cannot read.
glib-compile-schemas %{_datadir}/glib-2.0/schemas &>/dev/null || :

%postun
glib-compile-schemas %{_datadir}/glib-2.0/schemas &>/dev/null || :

%files
%license LICENSE
%doc README.md
%{extdir}
%{_datadir}/glib-2.0/schemas/org.gnome.shell.extensions.search-does-search.gschema.xml

%changelog
* Tue Sep 15 2026 dixonSolutions <radr60662@gmail.com> - 1.0.2-1
- Say so when there is no network, instead of rendering a failed page.
- Stop exporting frames while the overview is closed, and pace exports by what
  they actually cost.

* Tue Sep 15 2026 dixonSolutions <radr60662@gmail.com> - 1.0.1-1
- Fix the settings window: the prefs resource path was one the Shell never shipped.

* Tue Sep 15 2026 dixonSolutions <radr60662@gmail.com> - 1.0.0-1
- First packaged release.
