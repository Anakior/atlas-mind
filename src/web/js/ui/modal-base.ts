// Shared modal lifecycle. Subclasses add their open()/submit(); close() may be extended.
class Modal {
  constructor(protected readonly backdrop: HTMLElement) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.close();
    });
  }

  isOpen(): boolean {
    return !this.backdrop.classList.contains('hidden');
  }

  close(): void {
    this.backdrop.classList.add('hidden');
  }

  protected reveal(): void {
    this.backdrop.classList.remove('hidden');
  }
}
