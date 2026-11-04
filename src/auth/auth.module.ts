import { Global, Module } from '@nestjs/common';
import { AuthGuard, NoopProviderIdentityAdapter, PROVIDER_IDENTITY_PORT } from './auth.guard.js';

@Global()
@Module({
  providers: [
    { provide: PROVIDER_IDENTITY_PORT, useClass: NoopProviderIdentityAdapter },
    AuthGuard,
  ],
  exports: [PROVIDER_IDENTITY_PORT, AuthGuard],
})
export class AuthModule {}
