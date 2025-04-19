import type { JSX } from "preact";
import { cn } from "./utils.ts";

type Props = JSX.TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea(props: Props): JSX.Element {
  const { class: classProp, ...rest } = props;
  const className = cn(
    "bff-input",
    classProp,
  );
  return <textarea class={className} {...rest} />;
}
