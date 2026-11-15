# Latencia medida en la API de prueba de NVIDIA

Mediciones del 15 de noviembre de 2026 contra `integrate.api.nvidia.com` con una sola clave. Son muestras chicas y dependen de la hora: sirven para decidir el diseño, no como garantía.

## Qué se midió

| Prueba | Resultado |
|---|---|
| Modelo grande (Nemotron 3.5 Super VL 120B), 30 llamadas mínimas en serie | mediana 1,9 s; p90 6,0 s; 11 de 30 sobre 3 s |
| Las mismas 30 con carrera (segunda llamada a los 1,5 s si la primera no empezó a responder) | mediana 0,5 s; p90 2,9 s; 2 de 30 sobre 3 s; 39 llamadas en vez de 30 |
| Lightning 30B y Bolt e4b, 8 llamadas mínimas | 0,1 a 0,2 s todas |
| Ultra 550B, 8 llamadas con esquema | empieza a responder en menos de 1 s; total entre 1,2 y 16 s |
| Otros modelos del catálogo (DeepSeek, GLM, Gemma, Mistral, GPT-OSS, Step) | más de 15 s o error |

La espera del modelo grande no depende del largo de la respuesta: es cola antes de empezar. Con esquema JSON, el flujo llega completo al final, así que el streaming no adelanta texto, pero sus cabeceras sí avisan cuándo la llamada salió de la cola.

## Qué cambió en el intermediario

- **Carrera en el modelo grande.** Si la primera llamada no empezó a responder a los 1,5 s, sale una segunda, y a los 4,5 s una tercera. Gana la primera que termina. Hay un presupuesto de 16 coberturas por minuto, porque la API admite unas 40 llamadas por minuto entre todas las páginas.
- **Orientador en cascada.** Parte Ultra 550B, al segundo entra el modelo grande y a los 6 s Bolt como respaldo.

## Efecto

| Flujo | Antes | Después |
|---|---|---|
| Orientador, 32 casos | 31 de 32; mediana 13,6 s y hasta 60 s sin respuesta | 32 de 32; mediana 2,6 s; p90 4,0 s; máximo 5,5 s |
| Chat de normativa, 17 turnos, misma hora | 16 de 17; mediana 21,9 s; máximo 41,7 s | 16 de 17; mediana 12,0 s; máximo 23,6 s |
| Lectura de una foto (`/gauge`), 12 llamadas | mediana 3,4 s; una llamada de 60,7 s | mediana 4,2 s; máximo 8,1 s |

En la lectura de una foto la mediana no mejoró en esta muestra; lo que desapareció fue la llamada de un minuto.
