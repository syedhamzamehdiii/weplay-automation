import bcrypt from "bcryptjs";
import type { Operator } from "@weplay/types";
import { HttpError } from "../http.js";
import type { OperatorRepository } from "../repositories/OperatorRepository.js";

export class AuthService {
  constructor(private readonly operators: OperatorRepository) {}

  async login(username: string, password: string): Promise<Operator> {
    const operator = await this.operators.getByUsername(username);
    if (!operator) {
      throw new HttpError(401, "Invalid credentials", "AUTH_REQUIRED");
    }
    const ok = await bcrypt.compare(password, operator.passwordHash);
    if (!ok) {
      throw new HttpError(401, "Invalid credentials", "AUTH_REQUIRED");
    }
    const { passwordHash: _ignored, ...safe } = operator;
    return safe;
  }

  async getById(id: string): Promise<Operator | undefined> {
    return this.operators.getById(id);
  }
}
