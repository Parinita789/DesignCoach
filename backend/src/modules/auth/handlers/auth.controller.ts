import { Body, Controller, Get, HttpCode, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AUTH_BRUTE_FORCE_THROTTLE } from '../../throttling/throttle-presets';
import { AuthService } from '../services/auth.service';
import { UsersRepository } from '../repositories/users.repository';
import { AuthGuard } from '../guards/auth.guard';
import { Public } from '../decorators/public.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';
import { AuthenticatedUser, SafeUser } from '../types/auth.types';
import { SignupDto } from '../dto/signup.dto';
import { LoginDto } from '../dto/login.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersRepository,
  ) {}

  // 5 attempts per minute per IP, no per-user limit (since requests
  // are unauthenticated). Lets a legit user retry a few times after a
  // typo but slows scripted brute-force credential-stuffing to a crawl.
  @Post('signup')
  @Public()
  @HttpCode(201)
  @Throttle(AUTH_BRUTE_FORCE_THROTTLE)
  @ApiOperation({ summary: 'Create a new account and return a JWT + user.' })
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto.email, dto.password);
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @Throttle(AUTH_BRUTE_FORCE_THROTTLE)
  @ApiOperation({ summary: 'Exchange email + password for a JWT.' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  // /auth/me uses @UseGuards directly so it's protected immediately,
  // independent of whether AuthGuard is registered globally yet
  // app boot to validate a stored JWT.
  @Get('me')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Return the current authenticated user.' })
  async me(@CurrentUser() user: AuthenticatedUser | undefined): Promise<SafeUser> {
    if (!user) throw new NotFoundException('No authenticated user on the request.');
    const row = await this.users.findById(user.id);
    if (!row) throw new NotFoundException(`User ${user.id} not found.`);
    return { id: row.id, email: row.email, createdAt: row.createdAt };
  }
}
