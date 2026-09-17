/** Engine choices shared by the Shell UI, preferences and browser handoff. */
export const ENGINES: Record<string, {label: string; browser: (query: string) => string}> = {
  duckduckgo: {label: 'DuckDuckGo', browser: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web`},
  google: {label: 'Google', browser: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`},
  bing: {label: 'Bing', browser: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`},
  brave: {label: 'Brave Search', browser: q => `https://search.brave.com/search?q=${encodeURIComponent(q)}`},
  startpage: {label: 'Startpage', browser: q => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}`},
};
export function engineFor(id: string): {id: string; label: string; browser: (query: string) => string} {
  const key = Object.hasOwn(ENGINES, id) ? id : 'duckduckgo';
  return {id: key, ...ENGINES[key]};
}
