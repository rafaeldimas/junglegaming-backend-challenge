import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PROVIDER_IDENTITY } from '../config/tokens.js';
import { Inject } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Health endpoints and /metrics are intentionally open. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface ProviderIdentity {
  providerId: string;
  subject: string;
  scopes: string[];
}

/**
 * Extension point for provider authentication. The challenge does not
 * implement it (see ARCHITECTURE.md): the only implementation shipped is the
 * no-op adapter, which reports `enabled = false`.
 */
export interface ProviderIdentityPort {
  readonly enabled: boolean;
  resolve(request: unknown): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY_PORT = PROVIDER_IDENTITY;

@Injectable()
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  readonly enabled = false;

  async resolve(): Promise<ProviderIdentity | null> {
    return null;
  }
}

/**
 * Global guard. Today it is an explicit no-op: when the port is disabled every
 * request is allowed, except that the class documents where JWT validation,
 * scope checks and `providerId` binding would live.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY_PORT)
    private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    if (!this.identity.enabled) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ providerIdentity?: ProviderIdentity }>();
    const identity = await this.identity.resolve(request);
    if (identity === null) {
      return false;
    }
    request.providerIdentity = identity;
    return true;
  }
}
