import { error } from '../cli';

export class BaseError extends Error {
  constructor(message?: string, ErrorOptions?: ErrorOptions) {
    super(message, ErrorOptions);

    error(`DBError`, this.message);
  }
}

export class FailedToInsertUserError extends BaseError {
  constructor() {
    super(`Failed to insert user`);
    this.name = 'FailedToInsertUser';
  }
}

export class UserNotFoundError extends BaseError {
  constructor(id: string) {
    super(`User not found for ${id}`);
    this.name = 'UserNotFound';
  }
}

export class FileCreateError extends BaseError {
  constructor(e: Error | string | undefined) {
    super(String(e ?? 'Failed to create file'));
    this.name = 'FileMakeError';
  }
}

export class KeyCollisionError extends BaseError {
  constructor() {
    super(`Key collision, try again.`);
    this.name = 'KeyCollision';
  }
}
