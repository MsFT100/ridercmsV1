import { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        email?: string;
        name?: string;
        phone_number?: string;
        role?: string;
        [key: string]: any;
      };
      /**
       * Postgres search_path schema (set by schemaRouter via AsyncLocalStorage)
       * or the boilerplate 'public' if not overridden.
       */
      schema?: any;
    }
  }
}
