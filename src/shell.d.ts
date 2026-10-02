// The @girs/gnome-shell 50 typings declare SearchController as an empty class,
// but the Shell still has both methods (js/ui/searchController.js, 48 through
// 50) and they are the documented way to register a search provider. Drop this
// once the typings declare them again.
import 'resource:///org/gnome/shell/ui/searchController.js';

declare module 'resource:///org/gnome/shell/ui/searchController.js' {
  interface SearchController {
    addProvider(provider: object): void;
    removeProvider(provider: object): void;
  }
}
