FROM denoland/deno:2.2.3

WORKDIR /app

COPY ../deno.json /app/deno.json
COPY ../../examples/basic/ /app/examples/basic/
COPY ../../examples/blog/ /app/examples/blog/
COPY ../../examples/statusphere/ /app/examples/statusphere/
COPY ../../packages/bff/ /app/packages/bff/

RUN deno cache ./examples/basic/main.tsx

# Prefer not to run as root.
USER deno
EXPOSE 8080

CMD ["run", "-A", "./examples/basic/main.tsx"]