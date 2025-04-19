FROM denoland/deno:2.2.3

WORKDIR /app

COPY ../deno.json /app/deno.json
COPY ../../examples/basic/ /app/examples/basic/
COPY ../../examples/blog/ /app/examples/blog/
COPY ../../examples/statusphere/ /app/examples/statusphere/
COPY ../../examples/tangled_ascii/ /app/examples/tangled_ascii/
COPY ../../examples/image_gallery/ /app/examples/image_gallery/
COPY ../../examples/search_likes/ /app/examples/search_likes/
COPY ../../packages/bff/ /app/packages/bff/
COPY ../../packages/bff-cli/ /app/packages/bff-cli/

RUN deno cache ./examples/image_gallery/main.tsx

# Prefer not to run as root.
USER deno
EXPOSE 8080

CMD ["run", "-A", "./examples/image_gallery/main.tsx"]