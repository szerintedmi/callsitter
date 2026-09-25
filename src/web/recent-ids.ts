/** Remembers recently seen webhook ids so a redelivered event is handled once. */
export class RecentIds {
  private ids = new Set<string>();
  constructor(private max: number) {}
  /** false if `id` was seen already */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value!);
    return true;
  }
}
