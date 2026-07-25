import mongoose from "mongoose";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";

declare global {
  // eslint-disable-next-line no-var
  var mongooseConnection:
    | {
        conn: typeof mongoose | null;
        promise: Promise<typeof mongoose> | null;
      }
    | undefined;
}

const cached = global.mongooseConnection ?? {
  conn: null,
  promise: null,
};

global.mongooseConnection = cached;

export async function connectDatabase() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(env.MONGODB_URI)
      .then((mongooseInstance) => {
        logger.info("MongoDB connected");
        return mongooseInstance;
      });
  }

  cached.conn = await cached.promise;

  return cached.conn;
}