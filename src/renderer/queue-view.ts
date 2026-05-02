import type { SpotifyController, SpotifyState } from "./spotify-player";

interface QueueTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  artists?: { name: string }[];
  album?: { name: string; images: { url: string }[] };
  images?: { url: string }[];
  show?: { name: string; images?: { url: string }[] };
}

interface QueueResponse {
  currently_playing: QueueTrack | null;
  queue: QueueTrack[];
}

export class QueueView {
  private container: HTMLElement;
  private controller: SpotifyController;
  private current: QueueTrack | null = null;
  private items: QueueTrack[] = [];
  private loading = false;
  private refreshTimer: number | null = null;
  private lastTrackId: string | null = null;

  constructor(container: HTMLElement, controller: SpotifyController) {
    this.container = container;
    this.controller = controller;
    this.render();
    this.refresh();
    this.refreshTimer = window.setInterval(() => this.refresh(), 15000);
  }

  handleState(s: SpotifyState) {
    const id = s.track?.id ?? null;
    if (id === this.lastTrackId) return;
    this.lastTrackId = id;
    this.refresh();
  }

  dispose() {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
  }

  async refresh() {
    if (this.loading) return;
    this.loading = true;
    this.render();
    const res = (await window.headspace.spQueue()) as QueueResponse | { error: string } | null;
    this.loading = false;
    if (!res || "error" in res) {
      this.current = null;
      this.items = [];
      this.render(res && "error" in res ? res.error : undefined);
      return;
    }
    this.current = res.currently_playing;
    this.items = res.queue.slice(0, 24);
    this.render();
  }

  private render(error?: string) {
    this.container.innerHTML = "";

    const header = document.createElement("div");
    header.className = "qv-header";
    const title = document.createElement("div");
    title.className = "qv-title";
    title.textContent = "Up Next";
    const refresh = document.createElement("button");
    refresh.className = "qv-refresh";
    refresh.textContent = "↻";
    refresh.title = "Refresh queue";
    refresh.addEventListener("click", () => this.refresh());
    header.append(title, refresh);
    this.container.appendChild(header);

    if (error) {
      this.appendEmpty(`Queue unavailable: ${error}`);
      return;
    }

    if (this.loading && !this.current && !this.items.length) {
      this.appendEmpty("Loading queue...");
      return;
    }

    if (this.current) {
      const label = document.createElement("div");
      label.className = "qv-section-label";
      label.textContent = "Now";
      this.container.appendChild(label);
      this.container.appendChild(this.row(this.current, true));
    }

    const label = document.createElement("div");
    label.className = "qv-section-label";
    label.textContent = "Next";
    this.container.appendChild(label);

    if (!this.items.length) {
      this.appendEmpty("Nothing queued yet. Add tracks from the right drawer.");
      return;
    }

    const list = document.createElement("div");
    list.className = "qv-list";
    this.items.forEach((item, idx) => list.appendChild(this.row(item, false, idx + 1)));
    this.container.appendChild(list);
  }

  private appendEmpty(text: string) {
    const empty = document.createElement("div");
    empty.className = "qv-empty";
    empty.textContent = text;
    this.container.appendChild(empty);
  }

  private row(item: QueueTrack, current: boolean, index = 0) {
    const row = document.createElement("button");
    row.className = current ? "qv-row qv-current" : "qv-row";
    row.title = current ? "Currently playing" : "Play this item";
    row.addEventListener("click", () => {
      if (!current) void this.controller.playTrack(item.uri);
    });

    const thumbUrl = item.album?.images?.at(-1)?.url ?? item.images?.at(-1)?.url ?? item.show?.images?.at(-1)?.url;
    if (thumbUrl) {
      const img = document.createElement("img");
      img.className = "qv-thumb";
      img.src = thumbUrl;
      img.loading = "lazy";
      row.appendChild(img);
    } else {
      const thumb = document.createElement("div");
      thumb.className = "qv-thumb qv-thumb-placeholder";
      thumb.textContent = current ? "▶" : String(index);
      row.appendChild(thumb);
    }

    const text = document.createElement("div");
    text.className = "qv-text";
    const name = document.createElement("div");
    name.className = "qv-name";
    name.textContent = item.name;
    const sub = document.createElement("div");
    sub.className = "qv-sub";
    sub.textContent = item.artists?.map((a) => a.name).join(", ") || item.show?.name || item.album?.name || "";
    text.append(name, sub);
    row.appendChild(text);

    return row;
  }
}
