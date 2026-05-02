/**
 * Library browser rendered inside the right-ear drawer.
 *
 * Shows a tab row (Search / Liked / Playlists / Recent) and a scrolling list.
 * Clicking a track triggers playback via the controller; clicking a playlist
 * drills in and plays the playlist.
 */

import type { SpotifyController } from "./spotify-player";

type Tab = "search" | "liked" | "playlists" | "recent" | "settings";

interface LibraryItem {
  kind: "track" | "playlist";
  id: string;
  uri: string;
  name: string;
  subtitle: string;
  thumbUrl?: string;
  contextUri?: string;
}

export type QueuedLibraryItem = Readonly<LibraryItem>;

const TAB_ORDER: Tab[] = ["search", "liked", "playlists", "recent"];
const TAB_TITLES: Record<Tab, string> = {
  search: "Search",
  liked: "Liked",
  playlists: "Playlists",
  recent: "Recent",
  settings: "Settings",
};

export class LibraryBrowser {
  private container: HTMLElement;
  private controller: SpotifyController;
  private currentTab: Tab = "liked";
  private items: LibraryItem[] = [];
  private isLoading = false;
  private searchQuery = "";
  private searchTimer: number | null = null;
  private errorText = "";

  private tabsEl: HTMLDivElement;
  private tabLabelEl: HTMLDivElement;
  private inputEl: HTMLInputElement;
  private listEl: HTMLDivElement;
  private renderSettings?: (container: HTMLElement) => void | Promise<void>;
  private onQueued?: (item: QueuedLibraryItem) => void;

  constructor(
    container: HTMLElement,
    controller: SpotifyController,
    opts: {
      renderSettings?: (container: HTMLElement) => void | Promise<void>;
      onQueued?: (item: QueuedLibraryItem) => void;
    } = {},
  ) {
    this.container = container;
    this.controller = controller;
    this.renderSettings = opts.renderSettings;
    this.onQueued = opts.onQueued;
    container.innerHTML = "";
    container.classList.add("lb-root");

    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "lb-tabs";
    container.appendChild(this.tabsEl);

    this.tabLabelEl = document.createElement("div");
    this.tabLabelEl.className = "lb-tab-label";
    container.appendChild(this.tabLabelEl);

    this.inputEl = document.createElement("input");
    this.inputEl.className = "lb-search";
    this.inputEl.placeholder = "Search Spotify...";
    this.inputEl.style.display = "none";
    this.inputEl.addEventListener("input", () => this.onSearchInput());
    container.appendChild(this.inputEl);

    this.listEl = document.createElement("div");
    this.listEl.className = "lb-list";
    container.appendChild(this.listEl);

    this.renderTabs();
    void this.loadTab("liked");
  }

  private renderTabs() {
    this.tabsEl.innerHTML = "";
    const tabs = this.renderSettings ? [...TAB_ORDER, "settings" as const] : TAB_ORDER;
    for (const t of tabs) {
      const b = document.createElement("button");
      b.className = "lb-tab";
      if (t === this.currentTab) b.classList.add("lb-tab-active");
      b.title = TAB_TITLES[t];
      const icon = document.createElement("span");
      icon.className = "lb-tab-icon";
      icon.dataset.tab = t;
      b.appendChild(icon);
      b.addEventListener("click", () => this.switchTab(t));
      this.tabsEl.appendChild(b);
    }
    this.tabLabelEl.textContent = TAB_TITLES[this.currentTab];
  }

  async switchTab(tab: Tab) {
    if (tab === this.currentTab) return;
    this.currentTab = tab;
    this.renderTabs();
    this.inputEl.style.display = tab === "search" ? "block" : "none";
    if (tab === "search") {
      this.inputEl.focus();
      this.items = [];
      this.errorText = "";
      this.renderList();
      if (this.searchQuery) await this.runSearch();
    } else if (tab === "settings") {
      await this.renderSettingsPanel();
    } else {
      await this.loadTab(tab);
    }
  }

  private async loadTab(tab: Exclude<Tab, "search" | "settings">) {
    this.isLoading = true;
    this.renderList();
    let result:
      | {
          items: Array<
            | { kind: "track"; track: SpotifyTrackLite; addedAt?: string }
            | { kind: "playlist"; playlist: SpotifyPlaylistLite }
          >;
        }
      | { error: string }
      | null = null;
    if (tab === "liked") {
      result = (await window.headspace.spLiked(0, 50)) as typeof result;
    } else if (tab === "playlists") {
      result = (await window.headspace.spPlaylists(0, 50)) as typeof result;
    } else if (tab === "recent") {
      result = (await window.headspace.spRecent(50)) as typeof result;
    }
    this.isLoading = false;
    if (!result || "error" in result) {
      this.items = [];
      this.errorText =
        result && "error" in result ? `Spotify error: ${result.error}` : "";
    } else {
      this.errorText = "";
      this.items = result.items.map(toLibraryItem);
    }
    this.renderList();
  }

  private async renderSettingsPanel() {
    this.items = [];
    this.isLoading = false;
    this.listEl.innerHTML = "";
    this.listEl.classList.add("lb-settings-list");
    if (this.renderSettings) {
      await this.renderSettings(this.listEl);
    }
  }

  private onSearchInput() {
    this.searchQuery = this.inputEl.value;
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => void this.runSearch(), 320);
  }

  private async runSearch() {
    if (!this.searchQuery.trim()) {
      this.items = [];
      this.errorText = "";
      this.renderList();
      return;
    }
    this.isLoading = true;
    this.renderList();
    const result = (await window.headspace.spSearch(this.searchQuery, 20)) as
      | {
          items: Array<
            | { kind: "track"; track: SpotifyTrackLite }
            | { kind: "playlist"; playlist: SpotifyPlaylistLite }
          >;
        }
      | { error: string }
      | null;
    this.isLoading = false;
    if (!result || "error" in result) {
      this.items = [];
      this.errorText =
        result && "error" in result ? `Spotify error: ${result.error}` : "";
    } else {
      this.errorText = "";
      this.items = result.items.map(toLibraryItem);
    }
    this.renderList();
  }

  private renderList() {
    this.listEl.classList.remove("lb-settings-list");
    this.listEl.innerHTML = "";
    if (this.isLoading) {
      const li = document.createElement("div");
      li.className = "lb-empty";
      li.textContent = "Loading...";
      this.listEl.appendChild(li);
      return;
    }
    if (!this.items.length) {
      const li = document.createElement("div");
      li.className = "lb-empty";
      li.textContent = this.emptyText();
      this.listEl.appendChild(li);
      return;
    }
    for (const item of this.items) {
      const row = document.createElement("div");
      row.className = "lb-item";
      if (item.uri === this.controller.state().track?.uri) {
        row.classList.add("lb-item-current");
      }
      if (item.thumbUrl) {
        const img = document.createElement("img");
        img.src = item.thumbUrl;
        img.className = "lb-thumb";
        img.loading = "lazy";
        row.appendChild(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "lb-thumb lb-thumb-placeholder";
        row.appendChild(ph);
      }
      const text = document.createElement("div");
      text.className = "lb-text";
      const title = document.createElement("div");
      title.className = "lb-title";
      title.textContent = item.name;
      const sub = document.createElement("div");
      sub.className = "lb-sub";
      sub.textContent = item.subtitle;
      text.appendChild(title);
      text.appendChild(sub);
      row.appendChild(text);

      row.addEventListener("click", () => this.onItemClick(item));

      if (item.kind === "track") {
        const queueBtn = document.createElement("button");
        queueBtn.className = "lb-queue";
        queueBtn.textContent = "ADD";
        queueBtn.title = "Add to queue";
        queueBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void this.onQueueClick(item, queueBtn);
        });
        row.appendChild(queueBtn);
      }

      this.listEl.appendChild(row);
    }
  }

  private onError: ((err: string) => void) | null = null;

  setErrorHandler(fn: (err: string) => void) {
    this.onError = fn;
  }

  private async onItemClick(item: LibraryItem) {
    const r =
      item.kind === "track"
        ? await this.controller.playTrack(item.uri, item.contextUri)
        : await this.controller.playContext(item.uri);
    if (!r.ok) this.onError?.(r.error);
  }

  private async onQueueClick(item: LibraryItem, btn: HTMLButtonElement) {
    if (item.kind !== "track") return;
    btn.disabled = true;
    btn.textContent = "...";
    const r = await this.controller.addToQueue(item.uri);
    if (!r.ok) {
      btn.disabled = false;
      btn.textContent = "ADD";
      this.onError?.(r.error);
      return;
    }
    btn.classList.add("lb-queue-ok");
    btn.textContent = "OK";
    this.onQueued?.(item);
    window.setTimeout(() => {
      btn.disabled = false;
      btn.classList.remove("lb-queue-ok");
      btn.textContent = "ADD";
    }, 1200);
  }

  private emptyText() {
    if (this.errorText) return this.errorText;
    if (this.currentTab === "search") {
      return this.searchQuery ? `No matches for "${this.searchQuery}"` : "Type to search";
    }
    return "Nothing here yet";
  }
}

interface SpotifyTrackLite {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
}

interface SpotifyPlaylistLite {
  id: string;
  name: string;
  uri: string;
  images: { url: string }[];
  owner: { display_name: string };
}

function toLibraryItem(
  src:
    | { kind: "track"; track: SpotifyTrackLite }
    | { kind: "playlist"; playlist: SpotifyPlaylistLite },
): LibraryItem {
  if (src.kind === "track") {
    const t = src.track;
    return {
      kind: "track",
      id: t.id,
      uri: t.uri,
      name: t.name,
      subtitle: t.artists.map((a) => a.name).join(", ") || t.album.name,
      thumbUrl: t.album.images[t.album.images.length - 1]?.url,
    };
  }
  const p = src.playlist;
  const owner = p.owner?.display_name ?? "Unknown";
  return {
    kind: "playlist",
    id: p.id,
    uri: p.uri,
    name: p.name,
    subtitle: owner,
    thumbUrl: p.images?.[p.images.length - 1]?.url,
  };
}
