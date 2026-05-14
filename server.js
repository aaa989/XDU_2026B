const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// API 配置
const BASE = 'https://mb44ub9ny4.re.qweatherapi.com';
const Q_KEY = '44912b526c474bb6baaea74cd1738b8c';

//  位置解析函数
async function resolveLocation(query) {
    const { lon, lat, city } = query;

    // 情况1：提供了经纬度 
    if (lon && lat) {
        console.log(`坐标模式: ${lon}, ${lat}`);
        
        // 尝试获取城市名称
        const cityName = await reverseGeocode(lon, lat);
        return { 
            locationName: cityName || `${lat}, ${lon}`, 
            coordStr: `${lon},${lat}`,
            lat: parseFloat(lat),
            lon: parseFloat(lon)
        };
    }

    // 情况2：提供了城市名
    if (city) {
        console.log(`城市搜索模式: "${city}"`);
        
        const geoResult = await geocode(city);
        if (geoResult) {
            console.log(`城市解析成功: ${geoResult.locationName} (${geoResult.lon}, ${geoResult.lat})`);
            return {
                locationName: geoResult.locationName,
                coordStr: `${geoResult.lon},${geoResult.lat}`,
                lat: geoResult.lat,
                lon: geoResult.lon
            };
        }
        throw new Error(`未找到城市"${city}"，请检查名称是否正确`);
    }
    throw new Error('请提供经纬度(lon,lat)或城市名(city)');
}

// 地理编码：城市名 → 经纬度
async function geocode(cityName) {
    const urls = [
        `${BASE}/geo/v2/city/lookup?location=${encodeURIComponent(cityName)}&key=${Q_KEY}`,
        `${BASE}/v2/city/lookup?location=${encodeURIComponent(cityName)}&key=${Q_KEY}`,
        `${BASE}/city/lookup?location=${encodeURIComponent(cityName)}&key=${Q_KEY}`,
    ];
    for (const url of urls) {
        try {
            console.log('尝试地理编码:', url);
            const res = await axios.get(url);
            
            if (res.data.code === '200' && res.data.location && res.data.location.length > 0) {
                const loc = res.data.location[0];
                const locationName = [loc.adm1, loc.adm2, loc.name]
                    .filter(Boolean)
                    .join(' ');
                return {
                    locationName,
                    lon: parseFloat(loc.lon),
                    lat: parseFloat(loc.lat)
                };
            }
        } catch (e) {
            console.log(`  失败: ${e.response?.status}`);
            continue;
        }
    }
    return null;
}

// 逆地理编码：经纬度 → 城市名
async function reverseGeocode(lon, lat) {
    const urls = [
        `${BASE}/geo/v2/city/lookup?location=${lon},${lat}&key=${Q_KEY}`,
        `${BASE}/v2/city/lookup?location=${lon},${lat}&key=${Q_KEY}`,
        `${BASE}/city/lookup?location=${lon},${lat}&key=${Q_KEY}`,
    ];
    for (const url of urls) {
        try {
            console.log('尝试逆地理编码:', url);
            const res = await axios.get(url);
            
            if (res.data.code === '200' && res.data.location && res.data.location.length > 0) {
                const loc = res.data.location[0];
                return [loc.adm1, loc.adm2, loc.name]
                    .filter(Boolean)
                    .join(' ');
            }
        } catch (e) {
            continue;
        }
    }
    return null;
}

// 能见度计算
function calculateVisibility(weatherText, humidity, pm25) {
    let visibilityStr = '>10km';

    if (weatherText?.includes('霾') || weatherText?.includes('雾') ||
        weatherText?.includes('Haze') || weatherText?.includes('Fog')) {
        if (pm25 > 150 || humidity > 90) {
            visibilityStr = (0.5 + Math.random() * 1.5).toFixed(1) + 'km';
        } else if (pm25 > 75 || humidity > 80) {
            visibilityStr = (1.5 + Math.random() * 2.5).toFixed(1) + 'km';
        } else {
            visibilityStr = (3 + Math.random() * 3).toFixed(1) + 'km';
        }
    } else if (pm25 > 100) {
        visibilityStr = (4 + Math.random() * 4).toFixed(1) + 'km';
    }
    return visibilityStr;
}

// 核心API路由
app.get('/api/weather', async (req, res) => {
    try {
        const { lon, lat, city } = req.query;

        if (!lon && !lat && !city) {
            return res.json({ 
                status: 'error', 
                message: '请提供经纬度(lon,lat)或城市名(city)' 
            });
        }
        // 解析位置
        const location = await resolveLocation({ lon, lat, city });
        console.log(`最终位置: ${location.locationName} (${location.lon}, ${location.lat})\n`);
        // 并行请求天气+空气+预报
        const [weatherRes, airRes, forecastRes] = await Promise.all([
            axios.get(`${BASE}/v7/weather/now?location=${location.coordStr}&key=${Q_KEY}`),
            axios.get(`${BASE}/airquality/v1/current/${location.lat}/${location.lon}?key=${Q_KEY}`),
            axios.get(`${BASE}/v7/weather/24h?location=${location.coordStr}&key=${Q_KEY}`)
        ]);
        // 检查天气响应
        if (weatherRes.data?.code !== '200') {
            return res.json({ 
                status: 'error', 
                message: `天气数据获取失败: code=${weatherRes.data?.code}` 
            });
        }
        // 检查预报响应
        if (forecastRes.data?.code !== '200') {
            return res.json({ 
                status: 'error', 
                message: `预报数据获取失败: code=${forecastRes.data?.code}` 
            });
        }
        const nowWeather = weatherRes.data.now;
        const forecastHourly = forecastRes.data.hourly;

        // 空气质量数据解析
        let airInfo = { aqi: '--', category: '未知', pm25: '--', pm10: '--', no2: '--' };
        // 解析 AQI 指数
        if (airRes.data?.indexes && airRes.data.indexes.length > 0) {
            let target = airRes.data.indexes.find(i =>
                i.code === 'cn-mee' || i.code === 'cn-mep' || i.name?.includes('AQI')
            );
            if (!target) target = airRes.data.indexes[0];

            airInfo.aqi = target.aqiDisplay || String(target.aqi) || '--';
            airInfo.category = target.category || '未知';
        }
        // 解析污染物浓度
        if (airRes.data?.pollutants && Array.isArray(airRes.data.pollutants)) {
            airRes.data.pollutants.forEach(item => {
                const concentrationValue = item.concentration?.value;
                
                if (concentrationValue !== undefined && concentrationValue !== null) {
                    switch (item.code) {
                        case 'pm2p5':
                            airInfo.pm25 = String(concentrationValue);
                            break;
                        case 'pm10':
                            airInfo.pm10 = String(concentrationValue);
                            break;
                        case 'no2':
                            airInfo.no2 = String(concentrationValue);
                            break;
                    }
                }
            });
            console.log('污染物解析:', { 
                pm25: airInfo.pm25 + 'μg/m³', 
                pm10: airInfo.pm10 + 'μg/m³', 
                no2: airInfo.no2 + 'μg/m³' 
            });
        }
        // 计算能见度
        const tempPm25 = parseFloat(airInfo.pm25) || 0;
        const humidityNum = parseInt(nowWeather.humidity) || 0;
        const visibilityStr = calculateVisibility(nowWeather.text, humidityNum, tempPm25);
        // 组装趋势数据
        const trend = { labels: [], temp: [], humidity: [] };
        if (forecastHourly && forecastHourly.length > 0) {
            forecastHourly.slice(0, 6).forEach(hour => {
                const time = hour.fxTime.includes('T') ?
                    hour.fxTime.split('T')[1].substring(0, 5) :
                    hour.fxTime.slice(-8, -3);
                trend.labels.push(time);
                trend.temp.push(parseFloat(hour.temp));
                trend.humidity.push(parseFloat(hour.humidity));
            });
        }
        // 构建响应
        const responseData = {
            location_name: location.locationName,
            aqi: airInfo.aqi,
            aqi_level: airInfo.category,
            pm25: airInfo.pm25,
            pm10: airInfo.pm10,
            no2: airInfo.no2,
            temp: nowWeather.temp,
            weather_main: nowWeather.text,
            weather_desc: `体感${nowWeather.feelsLike}°C ${nowWeather.windDir}`,
            humidity: nowWeather.humidity,
            wind: `${nowWeather.windDir} ${nowWeather.windScale}级`,
            vis: visibilityStr,
            feels_like: nowWeather.feelsLike,
            trend: trend
        };

        console.log('最终数据:', JSON.stringify(responseData, null, 2).substring(0, 500));
        res.json({ status: 'success', data: responseData });

    } catch (error) {
        console.error('请求失败:', error.message);

        if (error.response?.status === 403) {
            res.json({ status: 'error', message: 'API Key权限不足(403)，请检查Key是否有效' });
        } else if (error.response?.status === 404) {
            res.json({ status: 'error', message: 'API端点不存在(404)，请检查网络连接' });
        } else {
            res.status(500).json({ 
                status: 'error', 
                message: error.message || '服务器内部错误，请稍后再试' 
            });
        }
    }
});

// 启动服务器
app.listen(PORT, () => {
    console.log('环境雾霾探测系统后端');
    console.log(`访问地址: http://localhost:${PORT}`);
    console.log(`API Key: ${Q_KEY.substring(0, 8)}...`);
    console.log(`API Base: ${BASE}`);
});