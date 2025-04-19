import type { JSX } from "preact";
import { cn } from "./utils.ts";

type Props =
  & JSX.InputHTMLAttributes<HTMLInputElement>
  & Readonly<{
    variant?: "hidden";
  }>;

export function Input(props: Props) {
  const { variant, class: classProp, ...rest } = props;
  const className = cn(
    "bff-input",
    variant === "hidden" ? "hidden" : "",
    classProp,
  );
  return <input class={className} {...rest} />;
}
