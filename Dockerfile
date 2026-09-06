# Web UI Admin — container image
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    FLASK_APP=app.py \
    SERVICE_NAME=webui

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py backends.py metrics.py registry.py system_info.py ./
COPY templates ./templates
COPY static ./static

EXPOSE 8080

CMD ["python", "app.py"]