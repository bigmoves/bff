FROM denoland/deno:2.2.3

WORKDIR /app

COPY ../deno.json /app/deno.json
COPY ../../examples/basic/ /app/examples/basic/
COPY ../../examples/blog/ /app/examples/blog/
COPY ../../examples/statusphere/ /app/examples/statusphere/
COPY ../../examples/tangled_ascii/ /app/examples/tangled_ascii/
COPY ../../packages/bff/ /app/packages/bff/

RUN deno cache ./examples/blog/main.tsx

# Prefer not to run as root.
USER deno
EXPOSE 8080

CMD ["run", "-A", "./examples/blog/main.tsx"]