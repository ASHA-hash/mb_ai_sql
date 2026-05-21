# Smart ERP — single container: React build + FastAPI + SQL Server ODBC
FROM node:20-slim-bookworm AS frontend-build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
COPY assets ./assets
RUN cd frontend && npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app

# Microsoft ODBC Driver 18 for SQL Server (required by pyodbc)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg ca-certificates unixodbc unixodbc-dev \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" \
       > /etc/apt/sources.list.d/mssql-release.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend ./backend
COPY metadata ./metadata
COPY datasets-registry.js ./datasets-registry.js
COPY users-config.json ./users-config.json
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

ENV PYTHONUNBUFFERED=1
ENV MSSQL_ODBC_DRIVER="ODBC Driver 18 for SQL Server"

EXPOSE 8000
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
