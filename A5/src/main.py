from fastapi import FastAPI
from src.alignment_and_segmentation.router import router as alignment_router

app = FastAPI(title="Audio Alignment API")

# Include routers
app.include_router(alignment_router)

@app.get("/")
async def root():
    return {"message": "Audio Alignment API is running"}
