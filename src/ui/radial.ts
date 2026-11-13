/** One button on the ring. */
export interface RadialItem {
  /** One character on the button, and the name and detail shown in the hub while it is pointed at. */
  icon: string;
  label: string;
  hint?: () => string;
  enabled?: () => boolean;
  run: () => void;
  /** The item replaces the menu's content (a submenu) instead of finishing it. */
  stays?: boolean;
}

export interface RadialSpec {
  title: string;
  /** Image shown in the hub (a flag). */
  image?: string;
  /** Second line of the hub while no button is pointed at. */
  info?: () => string;
  items: RadialItem[];
  /** Show the troop share slider under the ring. */
  slider?: boolean;
}

const BUTTON = 44;

/**
 * A context menu that opens where the player clicked: actions on a ring
 * around a hub that names the place and whatever is pointed at. One instance
 * drives the `#radial` element.
 */
export class Radial {
  private readonly root: HTMLElement;
  private readonly hubTitle: HTMLElement;
  private readonly hubInfo: HTMLElement;
  private readonly hubImage: HTMLImageElement;
  private readonly ring: HTMLElement;
  private readonly sliderBox: HTMLElement;
  private spec: RadialSpec | null = null;
  private live: { button: HTMLButtonElement; item: RadialItem }[] = [];
  private pointed: RadialItem | null = null;
  /** Called when the menu closes, however that happened. */
  onClose: () => void = () => {};
  private dismissedAt = -Infinity;

  constructor(root: HTMLElement) {
    this.root = root;
    this.hubTitle = root.querySelector('.hub strong')!;
    this.hubInfo = root.querySelector('.hub span')!;
    this.hubImage = root.querySelector('.hub img')!;
    this.ring = root.querySelector('.ring')!;
    this.sliderBox = root.querySelector('.share')!;
    // A press anywhere else closes the menu - and that is all this press does.
    addEventListener(
      'pointerdown',
      (e) => {
        if (!this.isOpen || root.contains(e.target as Node)) return;
        this.dismissedAt = performance.now();
        this.close();
      },
      true,
    );
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** True for the click that has just closed the menu: it should not also act on what lies beneath. */
  get justDismissed(): boolean {
    return performance.now() - this.dismissedAt < 400;
  }

  /** Opens the menu centred on a point of the viewport, moved inwards if it would stick out. */
  open(x: number, y: number, spec: RadialSpec): void {
    this.spec = spec;
    this.pointed = null;
    const n = spec.items.length;
    const radius = Math.max(74, (n * (BUTTON + 8)) / (2 * Math.PI));
    const reach = radius + BUTTON / 2 + 8;
    const below = spec.slider ? 58 : 0;
    this.root.style.left = `${Math.min(innerWidth - reach, Math.max(reach, x))}px`;
    this.root.style.top = `${Math.min(innerHeight - reach - below, Math.max(reach, y))}px`;
    this.sliderBox.hidden = !spec.slider;
    this.sliderBox.style.top = `${reach}px`;
    this.hubTitle.textContent = spec.title;
    this.hubImage.hidden = !spec.image;
    if (spec.image) this.hubImage.src = spec.image;

    this.live = spec.items.map((item, i) => {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: item.icon });
      button.setAttribute('aria-label', item.label);
      button.style.left = `${Math.cos(angle) * radius}px`;
      button.style.top = `${Math.sin(angle) * radius}px`;
      const point = (on: boolean) => {
        this.pointed = on ? item : null;
        this.refresh();
      };
      button.addEventListener('pointerenter', () => point(true));
      button.addEventListener('pointerleave', () => point(false));
      button.addEventListener('focus', () => point(true));
      button.addEventListener('blur', () => point(false));
      button.addEventListener('click', () => {
        // A greyed-out button still explains itself in the hub, but does nothing.
        if (item.enabled && !item.enabled()) return;
        item.run();
        if (!item.stays) this.close();
      });
      return { button, item };
    });
    this.ring.replaceChildren(...this.live.map((l) => l.button));
    this.root.hidden = false;
    this.refresh();
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.spec = null;
    this.onClose();
  }

  /** Brings availability and the hub text up to date; the buttons themselves stay put under the cursor. */
  refresh(): void {
    if (!this.spec) return;
    for (const { button, item } of this.live) button.classList.toggle('off', item.enabled ? !item.enabled() : false);
    const info = this.pointed ? [this.pointed.label, this.pointed.hint?.()].filter(Boolean).join('\n') : (this.spec.info?.() ?? '');
    const title = this.pointed ? '' : this.spec.title;
    if (this.hubTitle.textContent !== title) this.hubTitle.textContent = title;
    if (this.hubInfo.textContent !== info) this.hubInfo.textContent = info;
    this.hubImage.hidden = !this.spec.image || this.pointed !== null;
  }
}
