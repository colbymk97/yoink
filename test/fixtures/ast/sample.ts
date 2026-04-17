// Module-level function
function greet(name: string): string {
  return `hello ${name}`;
}

class UserService {
  private readonly store: Map<string, string>;

  constructor() {
    this.store = new Map();
  }

  async validateToken(token: string): Promise<boolean> {
    if (!token) return false;
    return this.store.has(token);
  }

  addUser(id: string, name: string): void {
    this.store.set(id, name);
  }
}
