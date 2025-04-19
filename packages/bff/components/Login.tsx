import type { JSX } from "preact";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { cn } from "./utils.ts";

type Props =
  & JSX.HTMLAttributes<HTMLFormElement>
  & Readonly<{
    error?: string;
  }>;

export function Login(
  { error, ...rest }: Props,
): JSX.Element {
  return (
    <form
      id="login-form"
      hx-post="/oauth/login"
      hx-target="#login-form"
      hx-swap="outerHTML"
      {...rest}
      class={cn(
        "tw:mx-4 tw:sm:mx-0 tw:w-full tw:sm:max-w-[300px] tw:space-y-2",
        rest.class,
      )}
    >
      <div>
        <label htmlFor="handle" class="tw:sr-only">
          Handle
        </label>
        <Input
          id="handle"
          class="input"
          placeholder="Handle (e.g., user.bsky.social)"
          name="handle"
        />
      </div>
      <Button
        variant="primary"
        id="submit"
        type="submit"
        class="tw:w-full"
      >
        Login with AT Protocol
      </Button>
      <div className="tw:h-4">
        {error ? <div className="tw:text-sm tw:font-mono">{error}</div> : null}
      </div>
    </form>
  );
}
