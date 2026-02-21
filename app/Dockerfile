FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
COPY pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm build

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000

# Push DB schema (pipe yes to auto-confirm prompts) then start the server
CMD yes | pnpm db:push && pnpm start
