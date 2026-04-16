const STORAGE_KEY = "squads-viewer-labels";

let labels: Map<string, string> = new Map();

function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const entries: [string, string][] = JSON.parse(raw);
      labels = new Map(entries);
    }
  } catch {}
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...labels.entries()]));
  } catch {}
}

// Load on module init
load();

/**
 * Get the label for an address, or null if none set.
 */
export function getLabel(address: string): string | null {
  return labels.get(address) || null;
}

/**
 * Set a label for an address. Pass empty string to remove.
 */
export function setLabel(address: string, label: string): void {
  if (label.trim()) {
    labels.set(address, label.trim());
  } else {
    labels.delete(address);
  }
  save();
}

/**
 * Get all labels as a plain object (for Alpine reactivity).
 */
export function getAllLabels(): Record<string, string> {
  return Object.fromEntries(labels);
}
