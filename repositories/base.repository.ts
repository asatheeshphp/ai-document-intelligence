import { connectDatabase } from "@/db/database";

export abstract class BaseRepository<TDocument> {
  protected async withConnection<T>(operation: () => Promise<T>): Promise<T> {
    await connectDatabase();
    return operation();
  }
}
