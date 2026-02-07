# Server Load Testing Guide (Cloud Shell)

Since your local `kubectl` has issues, the best way to load test your server is to run everything inside **Google Cloud Shell**.

## Phase 1: Setup K6 in Cloud Shell

1.  Open your **Cloud Shell** terminal.
2.  Install `k6` using these commands:
    ```bash
    sudo gpg -k
    sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
    echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
    sudo apt-get update
    sudo apt-get install k6
    ```

3.  Upload your test scripts to Cloud Shell:
    - Click the **"Open Editor"** button in Cloud Shell.
    - Create a folder `load-tests`.
    - Create/Update `load-test.js` with the latest version (which supports `AUTH_TOKEN`).
    - Create `config.js` and paste the content from your local file.

## Phase 2: Open Tunnel to API Gateway

We need to connect `k6` (running in Cloud Shell) to your API Gateway (running in K8s).

1.  Open **Terminal 1** in Cloud Shell.
2.  Run the port forward:
    ```bash
    # Forward local port 3000 to the API Gateway's port 3000
    kubectl port-forward -n dev svc/apigw 3000:3000
    ```
    *(Keep this terminal open)*

## Phase 3: Run the Load Test (Authenticated)

Since your API requires a Firebase-verified token (and automating OTP is hard), we will **bypass login** by providing a valid token manually.

1.  **Get a Token:**
    - Open your mobile app (or Postman).
    - Login with your phone number/OTP.
    - Copy the `accessToken` (Bearer token) from the response or app logs.

2.  **Run Test:**
    Open **Terminal 2** in Cloud Shell and run:
    ```bash
    # Replace eyJhbG... with your ACTUAL long token string
    k6 run -e BASE_URL=http://localhost:3000 -e AUTH_TOKEN=eyJhbG... load-test.js
    ```

## Phase 4: Interpret Results

Since you are testing the **Use Real Server**, pay attention to:

1.  **`api_latency` (p95)**:
    - **< 200ms**: Excellent.
    - **200-500ms**: Good.
    - **> 1000ms**: The server is struggling (or network latency is high).

2.  **`errors`**:
    - Should be **0%**.
    - If you see errors, check `kubectl logs -n dev deploy/apigw`.

> **Note:** This tests the server logic and database performance, but it is limited by the "Port Forward" speed. For a true "Stress Test" (thousands of users), we would need to deploy `k6` inside the cluster itself, but this is perfect for checking stability.
