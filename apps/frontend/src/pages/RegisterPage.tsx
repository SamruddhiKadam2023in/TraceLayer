import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useLocation } from 'react-router';
import { PASSWORD_MIN_LENGTH, registerSchema, type RegisterInput } from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { register as registerAccount } from '@/services/auth.service';
import { fieldErrors, toApiError } from '@/utils/api-error';

const FIELDS = ['name', 'email', 'password', 'confirmPassword'] as const;

export function RegisterPage() {
  const location = useLocation();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '', confirmPassword: '' },
  });

  // On success the auth store updates and RedirectIfAuthenticated navigates away.
  const onSubmit = handleSubmit(async (values) => {
    try {
      await registerAccount(values);
    } catch (err) {
      const apiError = toApiError(err);
      const fields = fieldErrors(apiError);
      let matched = false;
      for (const field of FIELDS) {
        if (fields[field]) {
          setError(field, { message: fields[field] }, { shouldFocus: !matched });
          matched = true;
        }
      }
      if (!matched) setError('root', { message: apiError.message });
    }
  });

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-fg-muted">Start monitoring your APIs in minutes.</p>

      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4">
        {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}
        <TextField
          label="Name"
          autoComplete="name"
          autoFocus
          error={errors.name?.message}
          {...register('name')}
        />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={errors.password?.message}
          {...register('password')}
        />
        <TextField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />
        <Button type="submit" loading={isSubmitting} className="mt-1 w-full">
          Create account
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-fg-muted">
        Already have an account?{' '}
        <Link
          to="/login"
          state={location.state}
          className="font-medium text-accent hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
