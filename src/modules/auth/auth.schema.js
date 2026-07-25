import { z, strictObject } from '../../middleware/validate.js';

export const emailField = z.string().trim().toLowerCase().email('Enter a valid email address');

export const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), {
    message: 'Password must contain at least one letter and one number',
  });

export const registerBody = strictObject({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  email: emailField,
  password: passwordField,
});

export const loginBody = strictObject({
  email: emailField,
  password: z.string().min(1, 'Password is required').max(128),
  remember: z.boolean().default(false),
});

export const refreshBody = strictObject({
  refreshToken: z.string().min(10).optional(),
});

export const tokenBody = strictObject({
  token: z.string().min(10, 'Token is required'),
});

export const forgotPasswordBody = strictObject({ email: emailField });

export const resetPasswordBody = strictObject({
  token: z.string().min(10, 'Token is required'),
  password: passwordField,
});

export const oauthExchangeBody = strictObject({
  code: z.string().min(10, 'Code is required'),
});

export const providerParams = z.object({
  provider: z.enum(['google', 'github'], { message: 'Unsupported provider' }),
});
